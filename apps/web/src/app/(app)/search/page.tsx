import { Suspense } from 'react';

import { SemanticSearch } from '@/components/search/semantic-search';

export default function SearchPage() {
  return (
    <div className="grid gap-6">
      <h1 className="text-3xl font-bold tracking-tight">Search</h1>
      {/* useSearchParams (the query lives in the URL) needs a Suspense boundary. */}
      <Suspense>
        <SemanticSearch />
      </Suspense>
    </div>
  );
}
