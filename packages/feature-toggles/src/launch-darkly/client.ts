import LaunchDarkly from 'launchdarkly-node-server-sdk'
import { Logger } from 'typescript-log'
import { readLdAllFlagsResult } from './result-parser'
import { FeatureState, StringAnyMap } from '../universal'

export const serverSideRenderUser = { key: 'server-side-render' }

export const allToggles = async (
    ldClient: LaunchDarkly.LDClient,
    logger: Logger,
): Promise<FeatureState> => {
    const results = await ldClient.allFlagsState(serverSideRenderUser)

    logger.debug(results, 'LD Flags State')

    const items: StringAnyMap = results.toJSON()
    const features = readLdAllFlagsResult(items)

    return features
}

export const initialiseClient = (
    sdkKey: string | undefined,
    logger: Logger,
    featureStore: LaunchDarkly.LDFeatureStore,
) => {
    if (!sdkKey) {
        return
    }

    logger.debug(`Initialising launch darkly client with key ${sdkKey}`)
    return new Promise<LaunchDarkly.LDClient>((resolve, reject) => {
        // Downgrade 'Connection closed, reconnecting' message to info
        const loggerWithoutReconnErrors: LaunchDarkly.LDLogger = {
            error: (...args: any[]) => {
                const reconnecting = 'Connection closed, reconnecting'
                if ((args && args[0] === reconnecting) || args[1] === reconnecting) {
                    return (logger.info as any)(...args)
                }
                return (logger.error as any)(...args)
            },
            warn: (...args: any[]) => (logger.warn as any)(...args),
            info: (...args: any[]) => (logger.info as any)(...args),
            debug: (...args: any[]) => (logger.debug as any)(...args),
        }

        const ldClient = LaunchDarkly.init(sdkKey, {
            logger: loggerWithoutReconnErrors,
            featureStore,
        })

        const timeout = setTimeout(() => {
            ldClient.close()
            reject(new Error('Failed to initialise the launch darkly client'))
        }, 10000)

        ldClient.once('ready', async () => {
            const features = await allToggles(ldClient, logger)
            logger.info(
                `Launch darkly client initialised with features: ${JSON.stringify(features)}`,
            )

            clearTimeout(timeout)

            // Creates or updates our SSR User, all_flags doesn't create the user
            ldClient.identify(serverSideRenderUser)

            resolve(ldClient)
        })
    })
}

const maxDelayMs = 5 * 60 * 1000 // 5 minutes
export const getLaunchDarklyClientWithRetry = async (
    sdkKey: string | undefined,
    logger: Logger,
    featureStore: LaunchDarkly.LDFeatureStore,
) => {
    if (!sdkKey) {
        return
    }

    let prevDelayMs = 0
    let currentDelayMs = 100

    // We will just keep retrying until we are killed
    // eslint-disable-next-line no-constant-condition
    while (true) {
        try {
            return await initialiseClient(sdkKey, logger, featureStore)
        } catch (err) {
            if (currentDelayMs < maxDelayMs) {
                const newDelay = prevDelayMs + currentDelayMs
                prevDelayMs = currentDelayMs
                currentDelayMs = newDelay
            }

            logger.error(
                { err },
                `Failed to initialise launch darkly, waiting for ${currentDelayMs}ms before trying again`,
            )
            await new Promise(resolve => setTimeout(resolve, currentDelayMs))
        }
    }
}
