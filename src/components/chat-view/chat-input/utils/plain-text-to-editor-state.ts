import type { SerializedEditorState } from 'lexical'

/**
 * The inverse of `editorStateToPlainText`, which joins a paragraph's children
 * with no separator and renders `linebreak` as '\n': lines become `linebreak`
 * nodes inside ONE paragraph, so the text round-trips exactly. Separate
 * paragraphs would silently concatenate.
 *
 * Used wherever a message's text arrives as a plain string rather than from the
 * composer (the CLI surface's editable draft, a voice turn's committed text).
 */
export const plainTextToEditorState = (text: string): SerializedEditorState =>
  ({
    root: {
      children: [
        {
          children: text.split('\n').flatMap((line, index) => [
            ...(index > 0 ? [{ type: 'linebreak', version: 1 }] : []),
            ...(line
              ? [
                  {
                    detail: 0,
                    format: 0,
                    mode: 'normal',
                    style: '',
                    text: line,
                    type: 'text',
                    version: 1,
                  },
                ]
              : []),
          ]),
          direction: null,
          format: '',
          indent: 0,
          type: 'paragraph',
          version: 1,
        },
      ],
      direction: null,
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  }) as unknown as SerializedEditorState
