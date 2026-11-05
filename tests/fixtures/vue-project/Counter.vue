<template>
  <button @click="increment">{{ count }}</button>
</template>

<script>
import { ref } from "vue";
import { formatCount } from "./format.js";

export function increment(count) {
  return formatCount(count + 1);
}

export default {
  setup() {
    const count = ref(0);
    return { count, increment };
  },
};
</script>
