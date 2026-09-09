// @vitest-environment jsdom
/**
 * Client rendering of **audio** model-input descriptors (matrix AS-02,
 * AS-03, AS-06).
 *
 * Both renderers used to branch `part.type === 'text' ? … : <Image>`, so an
 * audio descriptor was displayed to the developer as an image. Each test
 * therefore asserts the positive "Audio" label AND the absence of the image
 * label — a fallthrough still renders a plausible-looking row, so a
 * positive-only assertion would not discriminate. The image fixtures are the
 * negative control (AS-06): they must keep rendering "Image" and never
 * "Audio".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { TraceEventList } from '../client/components/shared/TraceEventList';
import type { AxlEvent, ModelInputDescriptor } from '../client/lib/types';

const AUDIO_DESCRIPTOR: ModelInputDescriptor = {
  parts: [{ type: 'audio', source: 'base64', mediaType: 'audio/wav', bytes: 23 }],
};
const IMAGE_DESCRIPTOR: ModelInputDescriptor = {
  parts: [{ type: 'image', source: 'base64', mediaType: 'image/png', bytes: 8 }],
};

// ── SessionManagerPanel (AS-02) ─────────────────────────────────────────

const fetchSessionsMock = vi.fn();
const fetchSessionMock = vi.fn();
const deleteSessionMock = vi.fn();

vi.mock('../client/lib/api', async () => {
  const actual = await vi.importActual<typeof import('../client/lib/api')>('../client/lib/api');
  return {
    ...actual,
    fetchSessions: () => fetchSessionsMock(),
    fetchSession: (id: string) => fetchSessionMock(id),
    deleteSession: (id: string) => deleteSessionMock(id),
  };
});

beforeEach(() => {
  (Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView = vi.fn();
});
afterEach(() => {
  fetchSessionsMock.mockReset();
  fetchSessionMock.mockReset();
  deleteSessionMock.mockReset();
});

const { SessionManagerPanel } =
  await import('../client/panels/session-manager/SessionManagerPanel');

function renderWithQuery(node: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

async function openSessionWith(content: ModelInputDescriptor) {
  fetchSessionsMock.mockResolvedValue([{ id: 'sess-rich' }]);
  fetchSessionMock.mockResolvedValue({
    id: 'sess-rich',
    history: [{ role: 'user', content }],
  });
  renderWithQuery(<SessionManagerPanel />);
  fireEvent.click(await screen.findByText('sess-rich'));
  await waitFor(() => expect(screen.getByText('Rich model input')).toBeInTheDocument());
}

describe('SessionManagerPanel — rich input descriptors', () => {
  it('renders an audio-only descriptor as Audio, never as Image', async () => {
    await openSessionWith(AUDIO_DESCRIPTOR);

    expect(screen.getByText('Audio: base64 (audio/wav), 23 bytes')).toBeInTheDocument();
    expect(screen.queryByText(/Image/)).not.toBeInTheDocument();
  });

  it('still renders an image-only descriptor as Image, never as Audio', async () => {
    await openSessionWith(IMAGE_DESCRIPTOR);

    expect(screen.getByText('Image: base64 (image/png), 8 bytes')).toBeInTheDocument();
    expect(screen.queryByText(/Audio/)).not.toBeInTheDocument();
  });
});

// ── TraceEventList (AS-03) ──────────────────────────────────────────────

function askStartEvent(input: ModelInputDescriptor): AxlEvent {
  return {
    schemaVersion: 2,
    executionId: 'exec-1',
    step: 0,
    type: 'ask_start',
    timestamp: Date.now(),
    askId: 'ask-1',
    depth: 0,
    agent: 'listener',
    prompt: 'what do you hear?',
    input,
  } as unknown as AxlEvent;
}

async function expandFirstRow() {
  await userEvent.click(screen.getByText('ask_start'));
  await waitFor(() => expect(screen.getByText(/Model input:/)).toBeInTheDocument());
}

describe('TraceEventList — ask_start model input', () => {
  it('renders an audio descriptor as audio, never as image', async () => {
    render(<TraceEventList events={[askStartEvent(AUDIO_DESCRIPTOR)]} />);
    await expandFirstRow();

    expect(screen.getByText('audio (base64, audio/wav, 23 bytes)')).toBeInTheDocument();
    expect(screen.queryByText(/image \(/)).not.toBeInTheDocument();
  });

  it('still renders an image descriptor as image, never as audio', async () => {
    render(<TraceEventList events={[askStartEvent(IMAGE_DESCRIPTOR)]} />);
    await expandFirstRow();

    expect(screen.getByText('image (base64, image/png, 8 bytes)')).toBeInTheDocument();
    expect(screen.queryByText(/audio \(/)).not.toBeInTheDocument();
  });
});
