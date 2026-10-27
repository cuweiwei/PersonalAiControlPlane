import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { render } from './release-bundle.mjs';
mkdirSync('release-artifacts', { recursive: true });
writeFileSync('release-artifacts/compose.prod.yml', render(readFileSync('compose.prod.yml', 'utf8'), process.env.RELEASE_REPOSITORY, process.env.RELEASE_IMAGE_DIGEST));
