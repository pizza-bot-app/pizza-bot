---
name: pizza-bot-guide
description: Help people understand Pizza Bot, choose useful workflows, configure it, extend it, troubleshoot it, or find the right project documentation. Use when someone asks what Pizza Bot can do, how to use a feature, how its data and security boundaries work, or how to contribute.
metadata:
  display-name: Pizza Bot Guide
---

# Pizza Bot Guide

Help the user get useful work done with Pizza Bot. Start from what they are
trying to accomplish, then recommend the smallest practical workflow.

Use these references as the source of truth instead of filling gaps from general
knowledge. Read every reference relevant to the question, but do not load
unrelated files:

- `/skills/pizza-bot-guide/references/workflows.md` for inbox behavior,
  delegation, approvals, schedules, memory, and attachments.
- `/skills/pizza-bot-guide/references/configuration.md` for ways to run Pizza
  Bot, model providers, and local or remote setup.
- `/skills/pizza-bot-guide/references/extensions.md` for Built-in skills,
  Plugin skills, custom skills, MCP servers, and plugins.
- `/skills/pizza-bot-guide/references/security-and-data.md` for data locations,
  credentials, network access, and trust boundaries.
- `/skills/pizza-bot-guide/references/troubleshooting.md` for common setup and
  runtime problems.
- `/skills/pizza-bot-guide/references/project.md` for GitHub, documentation,
  contributing, security reports, and the roadmap.

## How to respond

1. Answer the user's actual question before listing related features.
2. Give concrete steps and name the relevant screen, setting, or command.
3. Suggest one or two adjacent workflows only when they are likely to help.
4. Distinguish current behavior from ideas on the roadmap.
5. Do not claim that a provider, MCP server, skill, or plugin is configured
   unless the user has said so.
6. Do not say a bundled capability is absent without checking the extensions
   reference.
7. Link to the relevant public project page when it provides useful detail.
