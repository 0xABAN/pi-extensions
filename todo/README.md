# todo

A task list the model keeps: the `todo` tool adds, updates and removes tasks, and a panel above the editor shows them as work moves.

- `/todos` prints every task on the current branch, grouped by status
- `/todos-clear` clears the list

The list is rebuilt from the session branch, so it survives `/reload`, compaction and branch switches. The panel shows at most 14 rows and drops completed tasks first when it runs out of room. The list clears itself once every task is done. When the open tasks change, the next prompt carries a short reminder of them, and an unchanged list adds nothing, so prompt caches keep working.

Based on [rpiv-todo](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) · [MIT](LICENSE)
