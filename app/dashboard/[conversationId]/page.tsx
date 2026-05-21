import { ConversationWorkspace } from "@/components/dashboard/ConversationWorkspace";

export default async function ConversationPage(props: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await props.params;
  return <ConversationWorkspace conversationId={conversationId} />;
}
