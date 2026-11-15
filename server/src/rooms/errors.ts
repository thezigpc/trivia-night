import { ERRORS } from "@trivia/shared";

export type ErrorCode = keyof typeof ERRORS;

/** A refused intent: a stable code for logs, and the message people see. */
export class GameError extends Error {
  constructor(public readonly code: ErrorCode) {
    super(ERRORS[code]);
  }
}
