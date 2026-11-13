/** A route result that becomes a 302 instead of JSON (OAuth hops). */
export class Redirect {
  readonly location: string;
  readonly headers: Record<string, string>;
  constructor(location: string, headers: Record<string, string> = {}) {
    this.location = location;
    this.headers = headers;
  }
}

/** A route result sent as an HTML page instead of JSON (the dev-only mock consent screen). */
export class HtmlPage {
  readonly body: string;
  constructor(body: string) {
    this.body = body;
  }
}
