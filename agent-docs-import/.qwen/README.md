# Qwen Local Model Configuration

This directory contains Qwen/local-model configuration.

The configuration here should control model/runtime behavior, not repository architecture.

## Recommended responsibilities

Use `.qwen/settings.json` for settings such as:
- selected model
- local endpoint
- context limits
- temperature
- tool-call configuration
- timeout/step limits
- runtime feature flags

Do not store secrets in this directory.

## Important

A model configuration file does not make the model autonomous by itself.

The local agent runtime must still provide:
- repository tools
- file access
- command execution
- tool-call handling
- iteration/agent loop
- permission checks
- verification
- task state

The runtime should load the applicable repository `AGENTS.md` files and pass them into the model context.
