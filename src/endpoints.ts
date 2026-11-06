// Registered receivers. Each endpoint gets its own signing secret, so a
// signature issued to one receiver is worthless at any other.

import { randomBytes, randomUUID } from "node:crypto";

export interface Endpoint {
  id: string;
  url: string;
  /** HMAC key shared with this receiver only. Returned once, at registration. */
  secret: string;
  createdAt: number;
}

export class EndpointRegistry {
  private byId = new Map<string, Endpoint>();

  register(url: string, now = Date.now()): Endpoint {
    const endpoint: Endpoint = {
      id: randomUUID(),
      url,
      secret: randomBytes(32).toString("base64url"),
      createdAt: now,
    };
    this.byId.set(endpoint.id, endpoint);
    return endpoint;
  }

  get(id: string): Endpoint | undefined {
    return this.byId.get(id);
  }
}
