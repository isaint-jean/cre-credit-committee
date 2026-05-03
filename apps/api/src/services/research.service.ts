import { ResearchResult } from '@cre/shared';
import { env } from '../config/env.js';

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  age?: string;
}

async function braveSearch(query: string): Promise<ResearchResult[]> {
  if (!env.braveSearchApiKey) {
    return [{
      title: 'Search API not configured',
      url: '',
      snippet: 'Set BRAVE_SEARCH_API_KEY in .env to enable external research.',
      source: 'system',
      riskSignal: 'neutral',
    }];
  }

  try {
    const params = new URLSearchParams({
      q: query,
      count: '5',
      freshness: 'py', // past year
    });

    const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: {
        'Accept': 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': env.braveSearchApiKey,
      },
    });

    if (!response.ok) {
      console.error('Brave Search error:', response.status, await response.text());
      return [];
    }

    const data = await response.json() as any;
    const results: BraveSearchResult[] = data.web?.results || [];

    return results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      source: new URL(r.url).hostname,
      publishedDate: r.age || undefined,
      riskSignal: classifyRiskSignal(r.title + ' ' + r.description),
    }));
  } catch (error) {
    console.error('Research search failed:', error);
    return [];
  }
}

function classifyRiskSignal(text: string): 'negative' | 'neutral' | 'positive' {
  const lower = text.toLowerCase();
  const negativeKeywords = [
    'lawsuit', 'sued', 'fraud', 'bankruptcy', 'default', 'foreclosure',
    'investigation', 'violation', 'penalty', 'fine', 'criminal', 'indicted',
    'decline', 'loss', 'negative', 'downturn', 'vacancy', 'crime',
  ];
  const positiveKeywords = [
    'award', 'growth', 'expansion', 'upgrade', 'investment', 'improvement',
  ];

  const negCount = negativeKeywords.filter((k) => lower.includes(k)).length;
  const posCount = positiveKeywords.filter((k) => lower.includes(k)).length;

  if (negCount > posCount) return 'negative';
  if (posCount > negCount) return 'positive';
  return 'neutral';
}

export async function searchSponsor(sponsorName: string): Promise<{
  results: ResearchResult[];
  searchQuery: string;
}> {
  const query = `"${sponsorName}" lawsuit OR bankruptcy OR fraud OR default OR litigation real estate`;
  const results = await braveSearch(query);
  return { results, searchQuery: query };
}

export async function searchMarket(
  address: string,
  city: string
): Promise<{ results: ResearchResult[]; searchQuery: string }> {
  const year = new Date().getFullYear();
  const query = `"${city}" commercial real estate market ${year} vacancy absorption`;
  const results = await braveSearch(query);
  return { results, searchQuery: query };
}

export async function searchNews(
  propertyName: string,
  sponsorName: string
): Promise<{ results: ResearchResult[]; searchQuery: string }> {
  const query = `"${propertyName}" OR "${sponsorName}" real estate news`;
  const results = await braveSearch(query);
  return { results, searchQuery: query };
}

export async function searchCrime(
  address: string,
  city: string
): Promise<{ results: ResearchResult[]; searchQuery: string }> {
  const query = `"${city}" crime rate statistics ${new Date().getFullYear()}`;
  const results = await braveSearch(query);
  return { results, searchQuery: query };
}
