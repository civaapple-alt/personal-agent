import { type Questions, type SystemOneRequest, type SystemOneResult, TypeSafeClient } from "@typesafe-ai/sdk";

export { type ChoiceQuestion, choice, noul } from "@typesafe-ai/sdk";

export interface DecisionClassifier {
	evaluate<const Q extends Questions>(
		request: SystemOneRequest<Q>,
		signal: AbortSignal,
	): Promise<SystemOneResult<Q>["answers"]>;
}

export function createSystemOneClassifier(apiKey: string): DecisionClassifier {
	const client = new TypeSafeClient({
		apiKey,
		baseURL: "https://api.typesafe.ai",
		defaultModel: "jev-latest",
		timeout: 2_500,
		retry: { maxRetries: 0 },
		compression: false,
		logLevel: "off",
	});
	return {
		async evaluate(request, signal) {
			const response = await client.systemOne(request, { signal });
			return response.answers;
		},
	};
}
