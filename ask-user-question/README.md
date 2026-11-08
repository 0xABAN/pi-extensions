# ask-user-question

Lets the model ask instead of guess: the `ask_user_question` tool opens a dialog under the transcript with up to four questions of two to four written-out options each.

- ↑/↓ and enter pick an option, or press its number
- tab moves between questions; the Submit tab reviews every answer and names the blank ones
- `Type something.` answers in your own words; on multi-select questions it joins the checked options
- `n` adds a note to a question, or a global note from the Submit tab
- ctrl+] collapses the dialog to one line and back; esc cancels the questionnaire

An option can carry a markdown preview, such as a mockup or code, shown beside the list. While a question waits, Pi's status shows that it is waiting on you. Runs without a UI get an error instead of a dialog.

Based on [rpiv-ask-user-question](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-ask-user-question) · [MIT](LICENSE)
