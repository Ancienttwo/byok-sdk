import { sealedZeroHitSuite } from './sealed-zero-hit.test-support';
import { openHostedCloud, SKIP_HOSTED_CLOUD } from './hosted-cloud.test-support';

sealedZeroHitSuite('the sealed zero-hit run on the hosted SDK (#654 E6)', SKIP_HOSTED_CLOUD, openHostedCloud);
