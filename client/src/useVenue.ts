// The venue context on a Bar Games box (null standalone): the kit's useVenue keeps the
// --venue-* theme applied and refreshes it every 30 s. Off a box nothing changes.
import { useVenue as kitUseVenue } from "@bargames/gamekit/client";
import type { VenueContext } from "@bargames/sdk/client";
import { serverUrl } from "./socket";

export const useVenue = (): VenueContext | null => kitUseVenue(serverUrl || undefined);
