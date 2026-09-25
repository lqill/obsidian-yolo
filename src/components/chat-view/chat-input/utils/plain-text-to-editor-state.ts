import type {
  SerializedEditorState,
  SerializedElementNode,
  SerializedTextNode,
} from 'lexical'

type SerializedParagraphNode = SerializedElementNode<SerializedTextNode>

function createTextNode(text: string): SerializedTextNode {
  return {
    detail: 0,
    format: 0,
    mode: 'normal',
    style: '',
    text,
    type: 'text',
    version: 1,
  }
}

function createParagraphNode(text: string): SerializedParagraphNode {
  return {
    children: text.length > 0 ? [createTextNode(text)] : [],
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'paragraph',
    version: 1,
    textFormat: 0,
    textStyle: '',
  } as SerializedParagraphNode
}

/**
 * Inverse of `editorStateToPlainText`, for content that only exists as text —
 * a voice turn's transcript, which has no editor state behind it. Each line
 * becomes a paragraph, which is what the read-only card and the click-to-edit
 * editor both render, and what `editorStateToPlainText` round-trips to.
 */
export function plainTextToEditorState(text: string): SerializedEditorState {
  return {
    root: {
      children: text.split('\n').map(createParagraphNode),
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  }
}
