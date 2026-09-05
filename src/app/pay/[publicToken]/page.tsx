import { CustomerRecovery } from "@/components/customer-recovery";
import { getRepositoryForPublicToken } from "@/server/db/repository";

export const dynamic = "force-dynamic";

export default async function CustomerPage({ params }: { params: Promise<{ publicToken: string }> }) {
  const { publicToken } = await params;
  const repository = await getRepositoryForPublicToken(publicToken);
  const data = await repository?.getCustomerPage(publicToken);
  if (!data) return <main className="customer-page"><article className="customer-invalid"><h1>This payment page is unavailable</h1><p>This recovery link may be expired, revoked or already removed. Contact Northstar Office if you need help.</p><a className="button" href="mailto:collections@northstar.example">Reply by email</a></article></main>;
  return <CustomerRecovery data={data} publicToken={publicToken} />;
}
