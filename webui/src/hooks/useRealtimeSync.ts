import { useQueryClient } from "@tanstack/react-query";
import { useWebSocket, type WsServerMessage } from "./useWebSocket";

/**
 * Keeps REST-backed operational views current from the gateway's best-effort
 * WebSocket feed. The REST cache remains the source of truth after reconnects.
 */
export function RealtimeSync() {
  const queryClient = useQueryClient();

  useWebSocket((message: WsServerMessage) => {
    switch (message.type) {
      case "platform.inbound":
      case "platform.outbound":
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
        void queryClient.invalidateQueries({ queryKey: ["session"] });
        break;
      case "audit.append":
        void queryClient.invalidateQueries({ queryKey: ["audit"] });
        break;
      case "resync":
        void queryClient.invalidateQueries({ queryKey: ["sessions"] });
        void queryClient.invalidateQueries({ queryKey: ["session"] });
        void queryClient.invalidateQueries({ queryKey: ["audit"] });
        break;
      default:
        break;
    }
  });

  return null;
}
