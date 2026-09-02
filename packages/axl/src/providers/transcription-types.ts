import type { RecordedAudioSource, Transcript, TranscriptionRequest } from '../transcription.js';

export type TranscriptionCapabilities = {
  readonly sources: readonly RecordedAudioSource['type'][];
  readonly timestamps?: readonly ('segment' | 'word')[];
  readonly diarization?: boolean;
};

export type TranscriptionProviderRequest = Omit<TranscriptionRequest, 'model'> & {
  readonly model: string;
  readonly signal?: AbortSignal;
};

export type TranscriptionProviderResult = {
  readonly transcript: Transcript;
  /** Internal cleanup outcome. Never includes a provider file identifier. */
  readonly cleanupStatus?: 'not_required' | 'deleted' | 'failed' | 'timed_out';
};

export interface TranscriptionProvider {
  readonly capabilities: (model: string) => TranscriptionCapabilities | undefined;
  transcribe(request: TranscriptionProviderRequest): Promise<TranscriptionProviderResult>;
}
