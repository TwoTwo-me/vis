<template>
  <div class="pdf-viewer-root">
    <iframe :src="src" :title="title || 'PDF preview'" class="pdf-frame" />
  </div>
</template>

<script setup lang="ts">
defineProps<{
  src: string;
  title?: string;
}>();
</script>

<style scoped>
.pdf-viewer-root {
  width: 100%;
  height: 100%;
  background: #0f172a;
}

.pdf-frame {
  width: 100%;
  height: 100%;
  border: 0;
  display: block;
  background: #ffffff;
}
</style>
