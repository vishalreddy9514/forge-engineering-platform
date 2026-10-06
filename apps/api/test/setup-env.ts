// ConfigModule.forRoot() validates the environment when AppModule is imported, so test values
// must be in place before any test file loads the application.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'postgresql://forge:unused@localhost:5432/forge';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.CORS_ORIGINS = 'http://localhost:3000';
process.env.LOG_LEVEL = 'fatal';
process.env.S3_ENSURE_BUCKET = 'false';
process.env.METRICS_PORT = '0';
