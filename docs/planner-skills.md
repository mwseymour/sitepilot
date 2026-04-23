# Planner Skills

SitePilot planner skills are small instruction files that can be activated per request.

## How It Works

- Skill files live in `apps/desktop/planner-skills/*.md`.
- A request activates a skill by mentioning it with a `$name` token in the prompt.
- The desktop app loads matching skill files and injects their instructions into `plannerContext.activeSkills`.
- The planner treats those instructions as extra constraints for that one plan.

## Example

```text
Create a staff spotlight page with alternating image and text sections.
Use $alternating-layouts and $image-sourcing.
```

## Current Built-in Skills

- `$alternating-layouts`
- `$image-sourcing`

## Notes

- Skills are additive. They should guide layout or sourcing behavior, not override core safety rules.
- Missing skill names are ignored in v1.
- This keeps the planner extensible without hardcoding every layout pattern into the system prompt.
