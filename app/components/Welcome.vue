<template>
  <div class="welcome-content">
    <MessageViewer :code="markdown" lang="markdown" :theme="theme" />
  </div>
</template>

<script setup lang="ts">
import MessageViewer from './MessageViewer.vue';

defineProps<{
  theme: string;
}>();

const markdown = `\
# How To Use \`OpenCode Visualizer\`

This build expects managed mode.

- Browser traffic stays on the vis origin
- Vis relays REST, SSE, and PTY traffic to one upstream OpenCode server
- Edge auth should happen before requests reach vis

## Managed runtime contract

\`\`\`bash
VIS_MODE=managed
VIS_UPSTREAM_URL=https://opencode.internal.example
VIS_EDGE_AUTH_MODE=edge
VIS_UPSTREAM_AUTH_HEADER="Bearer server-side-token" # optional
\`\`\`

## Verify this deployment

\`\`\`bash
pnpm lint
pnpm build
pnpm test:managed
\`\`\`
`;
</script>

<style scoped>
.welcome-content {
  text-align: left;
  font-size: 12px;
  line-height: 1.5;
  color: #94a3b8;
}
</style>
