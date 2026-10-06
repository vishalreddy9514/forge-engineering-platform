import { z } from 'zod';

// Runs in the browser before any application code (Next.js instrumentation-client).
//
// Zod compiles fast object parsers with `new Function` when eval is allowed, and probes for it
// as soon as a schema is built, which @forge/types does when it loads. The CSP forbids eval,
// so the probe would report a violation on every page load (Zod falls back to its interpreter
// anyway). Use the interpreter from the start.
z.config({ jitless: true });
