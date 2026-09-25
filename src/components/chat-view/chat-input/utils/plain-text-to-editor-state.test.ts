import { editorStateToPlainText } from './editor-state-to-plain-text'
import { plainTextToEditorState } from './plain-text-to-editor-state'

/**
 * The pair only exists to move text between a message and the composer, so the
 * property that matters is that it survives the round trip untouched.
 */
describe('plainTextToEditorState', () => {
  it.each([
    ['a single line'],
    ['two\nlines'],
    ['trailing\n'],
    ['\nleading'],
    ['a\n\nb'],
    [''],
  ])('round-trips %j through editorStateToPlainText', (text) => {
    expect(editorStateToPlainText(plainTextToEditorState(text))).toBe(text)
  })
})
