export class MockTool {
  private _calls: { input: unknown }[] = [];

  constructor(
    readonly name: string,
    private handler: (input: unknown) => unknown | Promise<unknown>,
  ) {}

  get calls() {
    return this._calls;
  }

  async execute(input: unknown): Promise<unknown> {
    this._calls.push({ input });
    return this.handler(input);
  }

  static create(name: string, handler: (input: unknown) => unknown | Promise<unknown>): MockTool {
    return new MockTool(name, handler);
  }
}
