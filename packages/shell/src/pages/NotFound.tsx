import { Button, EmptyState, Page } from '@enterprise-ui/react';
import { navigate } from '@servermin/client';

export function NotFound() {
  return (
    <Page title="Page not found">
      <EmptyState icon="search" title="This page does not exist" description="The address may be mistyped, or the module that provided it was removed." actions={<Button onClick={() => navigate('/')}>Go to the dashboard</Button>} />
    </Page>
  );
}
