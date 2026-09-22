# Keep it safe

Give each agent only the credentials and access it needs. Store tokens as environment variables or through setup, never in a public document or screenshot. Use a test channel and test project before allowing an automation to touch production work.

For generated workflows, inspect every step and destination before saving. **Apply to canvas** replaces the current graph. For scheduled work, check the timezone and failure behavior. Review [Activity](../dashboard/activity.md) after the first run.

The daemon is intended to run behind a trusted local or private network boundary. If you need remote access, follow your organization's network and secret-management practices. See the [security policy](https://github.com/anis-marrouchi/agentx/blob/master/SECURITY.md) for reporting vulnerabilities.
