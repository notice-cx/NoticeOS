<script setup lang="ts">
import { computed, ref } from 'vue';
import { useData } from 'vitepress';

// "Was this page helpful?" with the reasons the best docs sites ask for.
// Nothing is tracked: an answer opens a prefilled GitHub issue naming the page,
// so a reader's note lands where the page is fixed.
const { page, site } = useData();
const repo = 'https://github.com/notice-cx/NoticeOS';
const answered = ref<'yes' | 'no' | null>(null);
const reasons = ["I couldn't find what I needed", 'It was hard to understand', 'It is out of date', 'Something is incorrect'];
const pagePath = computed(() => `docs/${page.value.filePath}`);
function issueUrl(reason: string) {
  const title = `Docs: ${page.value.title} — ${reason}`;
  const body = `Page: ${pagePath.value}\nSite: ${site.value.title}\n\nWhat was wrong, and what would have helped:\n\n`;
  return `${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=docs`;
}
</script>

<template>
  <div class="page-feedback" aria-label="Page feedback">
    <template v-if="answered === null">
      <span class="page-feedback__question">Was this page helpful?</span>
      <button type="button" class="page-feedback__button" @click="answered = 'yes'">Yes</button>
      <button type="button" class="page-feedback__button" @click="answered = 'no'">No</button>
    </template>
    <template v-else-if="answered === 'yes'">
      <span class="page-feedback__question">Thanks. <a :href="issueUrl('Something to add')" target="_blank" rel="noopener">Tell us what to add</a>.</span>
    </template>
    <template v-else>
      <span class="page-feedback__question">What went wrong?</span>
      <a v-for="reason in reasons" :key="reason" class="page-feedback__button" :href="issueUrl(reason)" target="_blank" rel="noopener">{{ reason }}</a>
    </template>
  </div>
</template>

<style scoped>
.page-feedback {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 32px 0 8px;
  padding-top: 16px;
  border-top: 1px solid var(--vp-c-divider);
  font-size: 14px;
  color: var(--vp-c-text-2);
}
.page-feedback__question {
  margin-right: 4px;
}
.page-feedback__button {
  border: 1px solid var(--vp-c-divider);
  border-radius: 6px;
  padding: 4px 10px;
  color: var(--vp-c-text-1);
  background: var(--vp-c-bg-soft);
  text-decoration: none;
  line-height: 1.4;
  cursor: pointer;
}
.page-feedback__button:hover {
  border-color: var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
}
</style>
