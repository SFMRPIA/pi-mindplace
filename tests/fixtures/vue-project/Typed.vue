<template>
  <div>{{ label }}</div>
</template>

<script lang="ts">
export interface Props {
  label: string;
}

export function renderLabel(props: Props): string {
  return props.label.trim();
}
</script>
