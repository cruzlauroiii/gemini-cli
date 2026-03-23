/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AgentCard,
  Message,
  MessageSendParams,
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '@a2a-js/sdk';
import type { AuthenticationHandler, Client } from '@a2a-js/sdk/client';
import {
  ClientFactory,
  ClientFactoryOptions,
  DefaultAgentCardResolver,
  JsonRpcTransportFactory,
  RestTransportFactory,
  createAuthenticatingFetchWithRetry,
} from '@a2a-js/sdk/client';
import { GrpcTransportFactory } from '@a2a-js/sdk/client/grpc';
import * as grpc from '@grpc/grpc-js';
import { v4 as uuidv4 } from 'uuid';
import { Agent as UndiciAgent, ProxyAgent } from 'undici';
import { normalizeAgentCard } from './a2aUtils.js';
import type { Config } from '../config/config.js';
import { debugLogger } from '../utils/debugLogger.js';
import type { AgentCardLoadOptions } from './types.js';
import { classifyAgentError } from './a2a-errors.js';
import type { A2AAuthConfig } from './auth-provider/types.js';
import { A2AAuthProviderFactory } from './auth-provider/factory.js';

/**
 * Result of sending a message, which can be a full message, a task,
 * or an incremental status/artifact update.
 */
export type SendMessageResult =
  | Message
  | Task
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

// Remote agents can take 10+ minutes (e.g. Deep Research).
// Use a dedicated dispatcher so the global 5-min timeout isn't affected.
const A2A_TIMEOUT = 1800000; // 30 minutes

/**
 * Orchestrates communication with remote A2A agents.
 * Manages protocol negotiation, authentication, and transport selection.
 */
export class A2AClientManager {
  // Each agent should manage their own context/taskIds/card/etc
  private clients = new Map<string, Client>();
  private agentCards = new Map<string, AgentCard>();

  private a2aDispatcher: UndiciAgent | ProxyAgent;
  private a2aFetch: typeof fetch;

  constructor(private readonly config: Config) {
    const proxyUrl = this.config.getProxy();
    const agentOptions = {
      headersTimeout: A2A_TIMEOUT,
      bodyTimeout: A2A_TIMEOUT,
    };

    if (proxyUrl) {
      this.a2aDispatcher = new ProxyAgent({
        uri: proxyUrl,
        ...agentOptions,
      });
    } else {
      this.a2aDispatcher = new UndiciAgent(agentOptions);
    }

    this.a2aFetch = (input, init) =>
      fetch(input, { ...init, dispatcher: this.a2aDispatcher } as RequestInit);
  }

  /**
   * Loads an agent by fetching its AgentCard and caches the client.
   * @param name The name to assign to the agent.
   * @param options The URL to the agent's card, or the inline JSON card representation.
   * @param authHandler Optional authentication handler to use for this agent.
   * @returns The loaded AgentCard.
   */
  async loadAgent(
    name: string,
    options: AgentCardLoadOptions,
    authConfig?: A2AAuthConfig,
  ): Promise<AgentCard> {
    if (this.clients.has(name) && this.agentCards.has(name)) {
      throw new Error(`Agent with name '${name}' is already loaded.`);
    }

    let authHandler: AuthenticationHandler | undefined;

    // 1. If we are loading from URL, we need auth upfront to fetch the card itself.
    if (authConfig && options.type === 'url') {
      const provider = await A2AAuthProviderFactory.create({
        authConfig,
        agentName: name,
        targetUrl: options.url,
        agentCardUrl: options.url,
      });
      if (!provider) {
        throw new Error(`Failed to create auth provider for agent '${name}'`);
      }
      authHandler = provider;
    }

    // Authenticated fetch for card fetching (only actually used if options.type === 'url')
    let cardFetchBase = this.a2aFetch;
    if (authHandler) {
      cardFetchBase = createAuthenticatingFetchWithRetry(
        this.a2aFetch,
        authHandler,
      );
    }
    const cardFetch = this.createCardFetch(
      authHandler ? cardFetchBase : undefined,
    );

    const rawCard = await this.resolveRawAgentCard(name, options, cardFetch);
    // TODO: Remove normalizeAgentCard once @a2a-js/sdk handles
    // proto field name aliases (supportedInterfaces → additionalInterfaces,
    // protocolBinding → transport).
    const agentCard = normalizeAgentCard(rawCard);

    // 2. If we loaded from JSON, we now have the parsed agentCard and its URL. We can construct Auth.
    if (authConfig && options.type === 'json') {
      const provider = await A2AAuthProviderFactory.create({
        authConfig,
        agentName: name,
        targetUrl: agentCard.url,
        agentCardUrl: agentCard.url,
      });
      if (!provider) {
        throw new Error(`Failed to create auth provider for agent '${name}'`);
      }
      authHandler = provider;
    }

    // Authenticated fetch for API calls (transports).
    let apiFetch = this.a2aFetch;
    if (authHandler) {
      apiFetch = createAuthenticatingFetchWithRetry(this.a2aFetch, authHandler);
    }

    const grpcUrl =
      agentCard.additionalInterfaces?.find((i) => i.transport === 'GRPC')
        ?.url ?? agentCard.url;

    const clientOptions = ClientFactoryOptions.createFrom(
      ClientFactoryOptions.default,
      {
        transports: [
          new RestTransportFactory({ fetchImpl: apiFetch }),
          new JsonRpcTransportFactory({ fetchImpl: apiFetch }),
          new GrpcTransportFactory({
            grpcChannelCredentials: grpcUrl?.startsWith('https://')
              ? grpc.credentials.createSsl()
              : grpc.credentials.createInsecure(),
          }),
        ],
        cardResolver:
          options.type === 'url'
            ? new DefaultAgentCardResolver({ fetchImpl: cardFetch })
            : undefined,
      },
    );

    try {
      const factory = new ClientFactory(clientOptions);
      const client = await factory.createFromAgentCard(agentCard);

      this.clients.set(name, client);
      this.agentCards.set(name, agentCard);

      debugLogger.debug(
        `[A2AClientManager] Loaded agent '${name}'${options.type === 'url' ? ` from ${options.url}` : ''}`,
      );

      return agentCard;
    } catch (error: unknown) {
      const sourceDesc =
        options.type === 'url' ? options.url : 'inline JSON reference';
      throw classifyAgentError(name, sourceDesc, error);
    }
  }

  /**
   * Invalidates all cached clients and agent cards.
   */
  clearCache(): void {
    this.clients.clear();
    this.agentCards.clear();
    debugLogger.debug('[A2AClientManager] Cache cleared.');
  }

  /**
   * Sends a message to a loaded agent and returns a stream of responses.
   * @param agentName The name of the agent to send the message to.
   * @param message The message content.
   * @param options Optional context and task IDs to maintain conversation state.
   * @returns An async iterable of responses from the agent (Message or Task).
   * @throws Error if the agent returns an error response.
   */
  async *sendMessageStream(
    agentName: string,
    message: string,
    options?: { contextId?: string; taskId?: string; signal?: AbortSignal },
  ): AsyncIterable<SendMessageResult> {
    const client = this.clients.get(agentName);
    if (!client) throw new Error(`Agent '${agentName}' not found.`);

    const messageParams: MessageSendParams = {
      message: {
        kind: 'message',
        role: 'user',
        messageId: uuidv4(),
        parts: [{ kind: 'text', text: message }],
        contextId: options?.contextId,
        taskId: options?.taskId,
      },
    };

    try {
      yield* client.sendMessageStream(messageParams, {
        signal: options?.signal,
      });
    } catch (error: unknown) {
      const prefix = `[A2AClientManager] sendMessageStream Error [${agentName}]`;
      if (error instanceof Error) {
        throw new Error(`${prefix}: ${error.message}`, { cause: error });
      }
      throw new Error(
        `${prefix}: Unexpected error during sendMessageStream: ${String(error)}`,
      );
    }
  }

  /**
   * Retrieves a loaded agent card.
   * @param name The name of the agent.
   * @returns The agent card, or undefined if not found.
   */
  getAgentCard(name: string): AgentCard | undefined {
    return this.agentCards.get(name);
  }

  /**
   * Retrieves a loaded client.
   * @param name The name of the agent.
   * @returns The client, or undefined if not found.
   */
  getClient(name: string): Client | undefined {
    return this.clients.get(name);
  }

  /**
   * Retrieves a task from an agent.
   * @param agentName The name of the agent.
   * @param taskId The ID of the task to retrieve.
   * @returns The task details.
   */
  async getTask(agentName: string, taskId: string): Promise<Task> {
    const client = this.clients.get(agentName);
    if (!client) throw new Error(`Agent '${agentName}' not found.`);
    try {
      return await client.getTask({ id: taskId });
    } catch (error: unknown) {
      const prefix = `A2AClient getTask Error [${agentName}]`;
      if (error instanceof Error) {
        throw new Error(`${prefix}: ${error.message}`, { cause: error });
      }
      throw new Error(`${prefix}: Unexpected error: ${String(error)}`);
    }
  }

  /**
   * Cancels a task on an agent.
   * @param agentName The name of the agent.
   * @param taskId The ID of the task to cancel.
   * @returns The cancellation response.
   */
  async cancelTask(agentName: string, taskId: string): Promise<Task> {
    const client = this.clients.get(agentName);
    if (!client) throw new Error(`Agent '${agentName}' not found.`);
    try {
      return await client.cancelTask({ id: taskId });
    } catch (error: unknown) {
      const prefix = `A2AClient cancelTask Error [${agentName}]`;
      if (error instanceof Error) {
        throw new Error(`${prefix}: ${error.message}`, { cause: error });
      }
      throw new Error(`${prefix}: Unexpected error: ${String(error)}`);
    }
  }

  private createCardFetch(authFetch?: typeof fetch): typeof fetch {
    return async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      // Try without auth first
      const response = await this.a2aFetch(input, init);

      // Retry with auth if we hit a 401/403
      if ((response.status === 401 || response.status === 403) && authFetch) {
        return authFetch(input, init);
      }

      return response;
    };
  }

  private async resolveRawAgentCard(
    name: string,
    options: AgentCardLoadOptions,
    cardFetch: typeof fetch,
  ): Promise<unknown> {
    if (options.type === 'json') {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(options.json);
        if (
          !parsedJson ||
          typeof parsedJson !== 'object' ||
          Array.isArray(parsedJson)
        ) {
          throw new Error('Parsed value is not a JSON object');
        }
      } catch (error) {
        throw new Error(
          `agentCardOptions.json must strictly parse into a valid JSON object: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      debugLogger.debug(
        `[A2AClientManager] Initializing agent '${name}' directly from agentCardJson`,
      );
      return parsedJson;
    }

    if (options.type === 'url') {
      const resolver = new DefaultAgentCardResolver({ fetchImpl: cardFetch });
      const rawCard = await resolver.resolve(options.url, '');
      debugLogger.debug(
        `[A2AClientManager] Resolved agent '${name}' card from ${options.url}`,
      );
      return rawCard;
    }

    throw new Error(
      `Invalid AgentCardLoadOptions type: ${String((options as { type?: string }).type)}`,
    );
  }
}
