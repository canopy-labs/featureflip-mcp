export const LANGUAGES = [
  'js', 'node', 'browser', 'react', 'python', 'csharp', 'java', 'go', 'php', 'ruby', 'swift',
] as const;

export type SnippetLanguage = (typeof LANGUAGES)[number];

// Languages whose snippet targets a client-side SDK (uses a CLIENT-side key).
// Client SDKs only receive flags where `clientSideVisible === true`, so any flag
// created for these must opt in at creation or it stays invisible to the SDK.
export const CLIENT_SIDE_LANGUAGES: readonly SnippetLanguage[] = ['browser', 'react', 'swift'];

export function isClientSideLanguage(language: SnippetLanguage): boolean {
  return CLIENT_SIDE_LANGUAGES.includes(language);
}

export interface Snippet {
  install: string;
  code: string;
  notes: string;
}

const SERVER_KEY_NOTE = 'Uses a SERVER-side SDK key (Featureflip dashboard → environment → SDK keys).';
const CLIENT_KEY_NOTE = 'Uses a CLIENT-side SDK key (safe to ship to browsers/apps).';

export function snippetFor(language: SnippetLanguage, flagKey: string): Snippet {
  switch (language) {
    case 'js':
      return {
        install: 'npm install @featureflip/js',
        code: `import { FeatureflipClient, createNodePlatform } from '@featureflip/js';

const client = FeatureflipClient.get(
  { sdkKey: process.env.FEATUREFLIP_SDK_KEY!, baseUrl: 'https://eval.featureflip.io' },
  createNodePlatform(),
);
await client.waitForInitialization();
const enabled = client.boolVariation('${flagKey}', { user_id: userId }, false);
if (enabled) {
  // new code path
}`,
        notes: SERVER_KEY_NOTE,
      };
    case 'node':
      return {
        install: 'npm install @featureflip/node',
        code: `import { FeatureflipClient } from '@featureflip/node';

const client = await FeatureflipClient.create({ sdkKey: process.env.FEATUREFLIP_SDK_KEY! });
const enabled = client.boolVariation('${flagKey}', { user_id: userId }, false);
if (enabled) {
  // new code path
}`,
        notes: SERVER_KEY_NOTE,
      };
    case 'browser':
      return {
        install: 'npm install @featureflip/browser',
        code: `import { FeatureflipClient } from '@featureflip/browser';

const client = FeatureflipClient.get({ clientKey: 'YOUR_CLIENT_SDK_KEY' });
await client.initialize();
const enabled = client.boolVariation('${flagKey}', false);
if (enabled) {
  // new code path
}`,
        notes: CLIENT_KEY_NOTE,
      };
    case 'react':
      return {
        install: 'npm install @featureflip/react @featureflip/browser',
        code: `import { FeatureflipProvider, useFeatureFlag } from '@featureflip/react';

// In your app root:
// <FeatureflipProvider clientKey="YOUR_CLIENT_SDK_KEY">...</FeatureflipProvider>

function MyComponent() {
  const enabled = useFeatureFlag('${flagKey}', false);
  return enabled ? <NewExperience /> : <CurrentExperience />;
}`,
        notes: CLIENT_KEY_NOTE,
      };
    case 'python':
      return {
        install: 'pip install featureflip',
        code: `from featureflip import FeatureflipClient

client = FeatureflipClient(sdk_key=os.environ["FEATUREFLIP_SDK_KEY"])
enabled = client.variation("${flagKey}", {"user_id": user_id}, default=False)
if enabled:
    # new code path
    ...`,
        notes: SERVER_KEY_NOTE,
      };
    case 'csharp':
      return {
        install: 'dotnet add package Featureflip.Client',
        code: `using Featureflip.Client;

var client = FeatureflipClient.Get(Environment.GetEnvironmentVariable("FEATUREFLIP_SDK_KEY")!);
var enabled = client.BoolVariation("${flagKey}",
    new EvaluationContext { UserId = userId }, false);
if (enabled)
{
    // new code path
}`,
        notes: SERVER_KEY_NOTE,
      };
    case 'java':
      return {
        install: "implementation 'io.featureflip:featureflip-java:2.0.0'",
        code: `import io.featureflip.client.FeatureflipClient;
import io.featureflip.client.EvaluationContext;

FeatureflipClient client = FeatureflipClient.get(System.getenv("FEATUREFLIP_SDK_KEY"));
client.waitForInitialization();
boolean enabled = client.boolVariation("${flagKey}",
    EvaluationContext.of(userId), false);
if (enabled) {
    // new code path
}`,
        notes: SERVER_KEY_NOTE,
      };
    case 'go':
      return {
        install: 'go get github.com/canopy-labs/featureflip-go',
        code: `import featureflip "github.com/canopy-labs/featureflip-go"

client, err := featureflip.Get(os.Getenv("FEATUREFLIP_SDK_KEY"))
if err != nil {
    log.Fatal(err)
}
defer client.Close()

ctx := featureflip.EvaluationContext{UserID: userID}
if client.BoolVariation("${flagKey}", ctx, false) {
    // new code path
}`,
        notes: SERVER_KEY_NOTE,
      };
    case 'php':
      return {
        install: 'composer require featureflip/featureflip-php',
        code: `use Featureflip\\FeatureflipClient;
use Featureflip\\Config;

$client = FeatureflipClient::get(getenv('FEATUREFLIP_SDK_KEY'), new Config(
    cache: $psrCache, httpClient: $psrHttpClient,
    requestFactory: $psrRequestFactory, streamFactory: $psrStreamFactory,
));
$enabled = $client->boolVariation('${flagKey}', ['user_id' => $userId], false);
if ($enabled) {
    // new code path
}`,
        notes: SERVER_KEY_NOTE + ' Requires PSR-16 cache and PSR-18 HTTP implementations.',
      };
    case 'ruby':
      return {
        install: 'gem "featureflip"',
        code: `require "featureflip"

client = Featureflip::Client.get(ENV.fetch("FEATUREFLIP_SDK_KEY"))
enabled = client.bool_variation("${flagKey}", { "user_id" => user_id }, false)
if enabled
  # new code path
end`,
        notes: SERVER_KEY_NOTE,
      };
    case 'swift':
      return {
        install: '.package(url: "https://github.com/canopy-labs/featureflip-swift", from: "2.0.0")',
        code: `import Featureflip

let config = FeatureflipConfig(clientKey: "YOUR_CLIENT_SDK_KEY")
let client = FeatureflipClient(config: config)
await client.initialize()
let enabled = client.boolVariation("${flagKey}", default: false)
if enabled {
    // new code path
}`,
        notes: CLIENT_KEY_NOTE,
      };
  }
}
