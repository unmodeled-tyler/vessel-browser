import Anthropic from '@anthropic-ai/sdk';

export class ClaudeClient {
  private client: Anthropic;
  private abortController: AbortController | null = null;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async streamQuery(
    systemPrompt: string,
    userMessage: string,
    onChunk: (text: string) => void,
    onEnd: () => void,
  ): Promise<void> {
    this.abortController = new AbortController();

    try {
      const stream = this.client.messages.stream(
        {
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: 'user', content: userMessage }],
        },
        { signal: this.abortController.signal },
      );

      for await (const event of stream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          onChunk(event.delta.text);
        }
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // Cancelled by user
      } else {
        onChunk(`\n\n[Error: ${err.message}]`);
      }
    } finally {
      this.abortController = null;
      onEnd();
    }
  }

  cancel(): void {
    this.abortController?.abort();
  }

  updateApiKey(apiKey: string): void {
    this.client = new Anthropic({ apiKey });
  }
}
