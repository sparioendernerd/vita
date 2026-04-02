# Scripts System

The gateway now supports a local `scripts/` registry for custom tools Graves can run without free-form shell commands.

## Folder layout

Each script lives in its own folder under the repo root:

```text
scripts/
  my_script/
    script.json
    ...any helper files...
```

## Manifest format

Each `script.json` uses this shape:

```json
{
  "name": "my_script",
  "description": "What the script does",
  "command": ["python", "main.py", "--topic", "{{topic}}"],
  "cwd": ".",
  "timeoutMs": 30000,
  "enabled": true,
  "args": [
    {
      "name": "topic",
      "description": "Topic to process",
      "required": true
    }
  ]
}
```

## Notes

- `name` is the tool-facing id Graves uses with `run_script`.
- `command` is an argument array, not a shell string. That keeps execution tighter and less stupid.
- `{{arg_name}}` placeholders are replaced from the `args` object passed to `run_script`.
- `cwd` is optional and stays confined to the script's own folder.
- Disabled scripts are ignored by `list_scripts`.

## Available tools

- `list_scripts`: returns the registered scripts and their argument definitions.
- `run_script`: runs one script by `name` with optional named `args`.

Example:

```json
{
  "name": "run_script",
  "args": {
    "name": "hello_vailen",
    "args": {
      "name": "Mr Vailen"
    }
  }
}
```

## Codex scaffolding

The local `scripts/codex_script_starter/` example uses Codex CLI to generate a new script folder from a prompt. It assumes `codex` is installed on the gateway machine and available on `PATH`.

Suggested flow:

1. Ask Graves to run `list_scripts`.
2. Ask him to run `codex_script_starter` with a script name and a build prompt.
3. Review the generated folder in `scripts/<name>/`.
4. Ask Graves to run the new script with `run_script`.
