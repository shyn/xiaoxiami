# Teams

Teams allow multiple agents to collaborate on a single task. A team consists of multiple agents with a designated leader that coordinates the work.

## Team Structure

```
Team Request
     │
     ▼
┌─────────┐
│ Leader  │ ────► Coordinates and delegates
│  Agent  │
└────┬────┘
     │
     ├───► Worker Agent 1
     ├───► Worker Agent 2
     └───► Worker Agent 3
```

## Configuration

Define teams in `settings.json`:

```json
{
  "teams": {
    "fullstack": {
      "name": "Full Stack Team",
      "agents": ["frontend", "backend", "devops"],
      "leader_agent": "backend"
    },
    "reviewers": {
      "name": "Code Review Team",
      "agents": ["security", "performance", "style"],
      "leader_agent": "security"
    }
  }
}
```

### Team Properties

| Property | Required | Description |
|----------|----------|-------------|
| `name` | Yes | Display name for the team |
| `agents` | Yes | List of agent IDs in the team |
| `leader_agent` | Yes | Agent ID that coordinates the team |

## Using Teams

To route a message to a team, prefix with `@team_id`:

```
@fullstack Build a complete login system with frontend form, backend API, and deployment
```

```
@reviewers Review this pull request for security issues, performance, and code style
```

## How Teams Work

1. **Message received** with `@team_id` prefix
2. **Leader agent** receives the full request
3. **Leader analyzes** and breaks down the task
4. **Leader delegates** subtasks to appropriate team members
5. **Team members** process their assigned parts
6. **Leader synthesizes** responses into final answer

## Example Team Configurations

### Full Stack Development Team
```json
{
  "agents": {
    "frontend": {
      "name": "Frontend Developer",
      "provider": "anthropic",
      "model": "sonnet",
      "working_directory": "frontend"
    },
    "backend": {
      "name": "Backend Developer",
      "provider": "anthropic",
      "model": "sonnet",
      "working_directory": "backend"
    },
    "devops": {
      "name": "DevOps Engineer",
      "provider": "anthropic",
      "model": "sonnet",
      "working_directory": "infrastructure"
    }
  },
  "teams": {
    "fullstack": {
      "name": "Full Stack Team",
      "agents": ["frontend", "backend", "devops"],
      "leader_agent": "backend"
    }
  }
}
```

### Code Review Team
```json
{
  "agents": {
    "security": {
      "name": "Security Reviewer",
      "provider": "anthropic",
      "model": "opus",
      "working_directory": "reviews"
    },
    "performance": {
      "name": "Performance Reviewer",
      "provider": "anthropic",
      "model": "sonnet",
      "working_directory": "reviews"
    },
    "style": {
      "name": "Style Reviewer",
      "provider": "anthropic",
      "model": "sonnet",
      "working_directory": "reviews"
    }
  },
  "teams": {
    "review": {
      "name": "Code Review Team",
      "agents": ["security", "performance", "style"],
      "leader_agent": "security"
    }
  }
}
```

### Content Creation Team
```json
{
  "agents": {
    "writer": {
      "name": "Technical Writer",
      "provider": "anthropic",
      "model": "sonnet",
      "working_directory": "content"
    },
    "editor": {
      "name": "Content Editor",
      "provider": "anthropic",
      "model": "sonnet",
      "working_directory": "content"
    },
    "illustrator": {
      "name": "Illustrator",
      "provider": "openai",
      "model": "gpt-5.3-codex",
      "working_directory": "content/images"
    }
  },
  "teams": {
    "content": {
      "name": "Content Team",
      "agents": ["writer", "editor", "illustrator"],
      "leader_agent": "editor"
    }
  }
}
```

## Best Practices

1. **Choose the Right Leader**: Select an agent with good coordination capabilities
   - Backend developers often make good leaders for full-stack tasks
   - Security reviewers are good leaders for code reviews

2. **Team Size**: Keep teams to 2-5 agents for efficiency

3. **Clear Responsibilities**: Each agent should have a distinct role

4. **Shared Working Directory**: Team members working on the same project should share a workspace or have coordinated directories

5. **Provider Consistency**: Team members should use the same provider (all Claude or all OpenAI) for consistent behavior

## Limitations

- Teams cannot be nested (a team cannot contain another team)
- An agent can belong to multiple teams
- The leader must be one of the agents in the `agents` list

## Troubleshooting

### Team not found
- Verify the team ID is correct in your message (`@team_name`)
- Check that the team is defined in settings.json

### Leader not responding
- Ensure the leader agent ID exists in the `agents` list
- Verify the leader agent configuration is valid

### Team members not participating
- Check that all agent IDs in the team are properly configured
- Review service logs for delegation messages
