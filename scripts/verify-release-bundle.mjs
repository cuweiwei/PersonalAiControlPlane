import { verify } from './release-bundle.mjs';
verify(process.env.BUNDLE_DIR ?? 'release-artifacts', process.env.RELEASE_REPOSITORY, process.env.RELEASE_COMMIT, process.env.RELEASE_IMAGE_DIGEST);
console.log('Release bundle verified');
