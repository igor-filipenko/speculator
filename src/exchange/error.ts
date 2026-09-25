/** Venue rejected a command (unsupported intent, missing market, API failure). */
export class ExchangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExchangeError";
  }
}
