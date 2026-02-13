# TinyClaw Documentation

Welcome to TinyClaw - a multi-channel AI agent orchestration platform.

## Overview

TinyClaw allows you to create and manage AI agents that can respond to messages from Discord, Telegram, and other channels. Agents can work individually or in teams to process incoming messages.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        TinyClaw                              │
├─────────────────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ WPF App  │  │  CLI     │  │ Service  │  │  Core    │    │
│  │   (UI)   │  │(Commands)│  │(Windows) │  │(Shared)  │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
│       └─────────────┴─────────────┴─────────────┘           │
│                          │                                  │
│                    ┌─────┴─────┐                            │
│                    │  SQLite   │                            │
│                    │  Queue    │                            │
│                    └─────┬─────┘                            │
│                          │                                  │
│       ┌──────────────────┼──────────────────┐               │
│       │                  │                  │               │
│  ┌────┴────┐       ┌────┴────┐       ┌────┴────┐           │
│  │ Discord │       │Telegram │       │  AI     │           │
│  │  Bot    │       │  Bot    │       │ Agents  │           │
│  └─────────┘       └─────────┘       └─────────┘           │
│                                                            │
└─────────────────────────────────────────────────────────────┘
```

## Components

| Component | Description |
|-----------|-------------|
| `TinyClaw.App` | WPF desktop application for management UI |
| `TinyClaw.Cli` | Command-line interface for scripting |
| `TinyClaw.Service` | Windows Service for background processing |
| `TinyClaw.Core` | Shared library (models, data access, services) |

## Quick Links

- [Configuration](configuration.md) - Settings and configuration options
- [Agents](agents.md) - Creating and managing agents
- [Teams](teams.md) - Working with agent teams
- [Channels](channels.md) - Discord and Telegram integration
- [Deployment](deployment.md) - Installing and running TinyClaw
