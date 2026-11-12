import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("assets/*", "routes/assets.$.tsx"),
  route("quests", "routes/quests.tsx"),
  route("quests/new", "routes/quests.new.tsx"),
  route("quests/:id", "routes/quests.$id.tsx"),
  route("sellers/reputation", "routes/sellers.reputation.tsx"),
  route("webhooks/stripe", "routes/webhooks.stripe.tsx"),
  route("webhooks/shipping", "routes/webhooks.shipping.tsx"),
] satisfies RouteConfig;
