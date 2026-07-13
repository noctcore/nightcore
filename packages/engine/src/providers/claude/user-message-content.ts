/**
 * Builds the Claude Agent SDK user-message `content` for a prompt plus optional
 * image attachments. Kept in its own module so the content-block assembly is
 * unit-testable in isolation, without spinning a `query()` or importing the rest
 * of the option-composition surface.
 */
import type { WireImage } from '@nightcore/contracts';

/** Map a contract image `format` token to the SDK base64 source `media_type`. The
 *  contract uses bare tokens (codegen-clean Rust enum variants); the SDK wants the
 *  full MIME type. */
const WIRE_IMAGE_MEDIA_TYPE: Record<
  WireImage['format'],
  'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** Build the SDK user-message content for a prompt + optional image attachments.
 *  Text-only stays a plain string (byte-identical to the pre-image shape); with
 *  attachments it becomes a content-block array — a text block followed by one
 *  base64 image block per attachment. `MessageParam.content` accepts both shapes.
 *  Exported for unit testing the block assembly. */
export function buildUserMessageContent(
  text: string,
  images: WireImage[] = [],
):
  | string
  | Array<
      | { type: 'text'; text: string }
      | {
          type: 'image';
          source: {
            type: 'base64';
            media_type: (typeof WIRE_IMAGE_MEDIA_TYPE)[WireImage['format']];
            data: string;
          };
        }
    > {
  if (images.length === 0) return text;
  return [
    { type: 'text' as const, text },
    ...images.map((image) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: WIRE_IMAGE_MEDIA_TYPE[image.format],
        data: image.data,
      },
    })),
  ];
}
