/**
 * Golden research briefs — the fixed corpus every baseline sweep runs against.
 *
 * Curated to span what the real consumers actually ask for: technical/RAG
 * infra (Sentigen WebResearch, tech-spec docs), market/competitive (market
 * report doc type), audience/social pain (Braintied course research), product
 * (PRD doc type), and client/proposal (client-brief / SOW-adjacent). Keep IDs
 * STABLE — they key the baseline JSON so versions diff cleanly. Add briefs;
 * never renumber existing ones.
 */

import type { ResearchKind } from '../src/index.js';

export interface GoldenBrief {
  id: string;
  domain: 'technical' | 'market' | 'audience' | 'product' | 'client';
  brief: string;
  /** The kind this brief is representative of (baseline runner may override). */
  suggestedKind: ResearchKind;
}

export const GOLDEN_BRIEFS: GoldenBrief[] = [
  // --- technical / RAG / infra -------------------------------------------
  {
    id: 'tech-01-crawlers',
    domain: 'technical',
    brief: 'What are the leading open-source web crawling tools for LLM/RAG pipelines in 2026, and how do Crawl4AI and Firecrawl compare on cost and capability?',
    suggestedKind: 'quick',
  },
  {
    id: 'tech-02-vector-db',
    domain: 'technical',
    brief: 'Compare pgvector, Qdrant, and Turbopuffer for a multi-tenant RAG workload in 2026 on cost, recall, and operational burden.',
    suggestedKind: 'standard',
  },
  {
    id: 'tech-03-rerankers',
    domain: 'technical',
    brief: 'What are the best cross-encoder and LLM-based rerankers available in 2026, and when is reranking worth the latency and cost?',
    suggestedKind: 'quick',
  },
  {
    id: 'tech-04-eval-frameworks',
    domain: 'technical',
    brief: 'Survey the state of the art for evaluating deep-research and RAG systems in 2026 (RACE, FACT, RAGAS, reference-free grounding).',
    suggestedKind: 'standard',
  },
  {
    id: 'tech-05-agent-memory',
    domain: 'technical',
    brief: 'How are production AI agents implementing long-term semantic memory in 2026, and what are the tradeoffs of vector recall vs summarization vs knowledge graphs?',
    suggestedKind: 'standard',
  },

  // --- market / competitive ----------------------------------------------
  {
    id: 'market-01-deep-research',
    domain: 'market',
    brief: 'Competitive landscape of managed deep-research products in 2026: OpenAI Deep Research, Gemini Deep Research, Perplexity, and Exa. Compare pricing, citation quality, and target user.',
    suggestedKind: 'standard',
  },
  {
    id: 'market-02-ai-assistants',
    domain: 'market',
    brief: 'Market map of AI executive-assistant products for founders and small teams in 2026 — positioning, pricing tiers, and the main gaps buyers complain about.',
    suggestedKind: 'standard',
  },
  {
    id: 'market-03-search-apis',
    domain: 'market',
    brief: 'Compare programmatic web-search APIs in 2026 (Tavily, Exa, Serper, SerpAPI, Brave) on price per thousand queries, result quality, and rate limits.',
    suggestedKind: 'quick',
  },
  {
    id: 'market-04-meeting-intel',
    domain: 'market',
    brief: 'Competitive analysis of meeting-intelligence products in 2026 (Fireflies, Otter, Fathom, Recall.ai) — feature depth, pricing, and integration breadth.',
    suggestedKind: 'standard',
  },
  {
    id: 'market-05-voice-agents',
    domain: 'market',
    brief: 'Landscape of real-time voice AI infrastructure in 2026 (LiveKit, Pipecat, Vapi, Retell) — self-host vs managed, latency, and cost at scale.',
    suggestedKind: 'quick',
  },

  // --- audience / social pain --------------------------------------------
  {
    id: 'audience-01-vibecoding',
    domain: 'audience',
    brief: 'What frustrations and desires do developers express in 2026 about AI code generation and "vibe coding" — where does generated code break down and what do they wish existed?',
    suggestedKind: 'social',
  },
  {
    id: 'audience-02-founder-ops',
    domain: 'audience',
    brief: 'What operational pain do solo founders and tiny teams describe in 2026 around managing email, meetings, and follow-ups, and which tools do they say fail them?',
    suggestedKind: 'social',
  },
  {
    id: 'audience-03-rag-builders',
    domain: 'audience',
    brief: 'What do engineers building RAG and research agents complain about most in 2026 (hallucinated citations, retrieval quality, cost) and what workarounds do they share?',
    suggestedKind: 'social',
  },
  {
    id: 'audience-04-course-buyers',
    domain: 'audience',
    brief: 'What do buyers of technical AI/coding courses in 2026 say motivates a purchase versus a refund, and what promises do they distrust?',
    suggestedKind: 'social',
  },

  // --- product / PRD-adjacent --------------------------------------------
  {
    id: 'product-01-research-fallback',
    domain: 'product',
    brief: 'Requirements and prior art for a self-hosted web-crawling fallback tier so a research pipeline keeps scraping when the primary crawler is down.',
    suggestedKind: 'quick',
  },
  {
    id: 'product-02-citation-ui',
    domain: 'product',
    brief: 'Best practices in 2026 for presenting inline citations and source provenance in an AI research report UI so users can verify claims quickly.',
    suggestedKind: 'quick',
  },
  {
    id: 'product-03-cost-guardrails',
    domain: 'product',
    brief: 'How do 2026 AI products implement per-user and per-workspace spend guardrails for LLM usage — patterns for caps, alerts, and graceful degradation.',
    suggestedKind: 'standard',
  },
  {
    id: 'product-04-onboarding',
    domain: 'product',
    brief: 'What onboarding patterns drive activation for AI assistant products in 2026, and what causes early drop-off?',
    suggestedKind: 'quick',
  },

  // --- client / proposal / SOW-adjacent ----------------------------------
  {
    id: 'client-01-healthtech-ai',
    domain: 'client',
    brief: 'Landscape and regulatory considerations for building an AI-driven patient-intake and triage tool in the US in 2026 (HIPAA, FDA SaMD, liability).',
    suggestedKind: 'standard',
  },
  {
    id: 'client-02-ecommerce-personalization',
    domain: 'client',
    brief: 'State of the art for AI product personalization and recommendation in ecommerce in 2026 — build vs buy, data requirements, and typical lift.',
    suggestedKind: 'quick',
  },
  {
    id: 'client-03-legal-ai',
    domain: 'client',
    brief: 'What are the proven and failed use cases for generative AI in legal workflows as of 2026, and where does hallucination risk make it unsuitable?',
    suggestedKind: 'standard',
  },
  {
    id: 'client-04-fintech-fraud',
    domain: 'client',
    brief: 'Approaches to AI-based fraud detection for a fintech payments product in 2026 — model types, data needs, false-positive tradeoffs, and vendors.',
    suggestedKind: 'quick',
  },
];

export function briefsByDomain(domain: GoldenBrief['domain']): GoldenBrief[] {
  return GOLDEN_BRIEFS.filter((b) => b.domain === domain);
}

/**
 * A cheap representative subset — one brief per domain, cheapest kind — for a
 * fast "does the harness work + rough numbers" run without the full spend.
 */
export const CHEAP_SUBSET_IDS: string[] = [
  'tech-01-crawlers',
  'market-03-search-apis',
  'audience-01-vibecoding',
  'product-01-research-fallback',
  'client-02-ecommerce-personalization',
];
