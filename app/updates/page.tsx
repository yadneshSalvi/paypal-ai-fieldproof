import { getSession } from "@/lib/server/auth";
import { readSupporterStory } from "@/lib/server/community";
import { SupporterStoryView } from "@/components/community/source-reading";
export const dynamic="force-dynamic";
export default async function Page(){const session=await getSession();return <SupporterStoryView projectId={session?.projectId??null} initial={session?await readSupporterStory(session):undefined}/>;}
