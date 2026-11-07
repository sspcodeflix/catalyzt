/**
 * Routes for App Context and Huddle, mounted by server/api.ts after the user and application are
 * resolved. Return true when the request was handled.
 *
 * Implemented in phase 3 (see SIMULATION_PLAN.md). Until then nothing is handled here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { AppRecord, HorizonDb, PersonRecord, Role } from './db';

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path without the query string, e.g. /api/context/sources. */
  url: string;
  method: string;
  query: URLSearchParams;
  db: HorizonDb;
  user: PersonRecord;
  /** The application the session is looking at; membership is already checked. */
  app: AppRecord;
  roles: Role[];
  readJson: (max?: number) => Promise<unknown>;
  send: (status: number, body: unknown) => void;
  /** Throw to answer with a status and message. */
  HttpError: new (status: number, message: string) => Error;
}

export async function extraRoutes(_ctx: RouteContext): Promise<boolean> {
  return false;
}
