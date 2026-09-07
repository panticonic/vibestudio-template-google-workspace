import { Badge, Card, Flex, Text } from "@radix-ui/themes";

interface WeatherState {
  city: string;
  tempF: number;
  condition: string;
}

type WeatherUpdate = Partial<WeatherState>;

export function reduce(state: WeatherState, update: WeatherUpdate): WeatherState {
  return { ...state, ...update };
}

export default function WeatherMessage({
  state,
  expanded,
}: {
  state: WeatherState;
  expanded: boolean;
}) {
  if (!expanded) {
    return (
      <Flex align="center" gap="1">
        <Text size="1" weight="medium">
          {state.city}
        </Text>
        <Text size="1" color="gray">
          {state.tempF}F
        </Text>
      </Flex>
    );
  }

  return (
    <Card>
      <Flex direction="column" gap="2">
        <Flex align="center" justify="between" gap="3">
          <Text size="3" weight="bold">
            {state.city}
          </Text>
          <Badge color="blue" variant="soft">
            {state.condition}
          </Badge>
        </Flex>
        <Text size="6" weight="bold">
          {state.tempF}F
        </Text>
      </Flex>
    </Card>
  );
}
