export {};

declare global {
    interface Window {
        i2b2?: {
            authorizedTunnel?: {
                function: {
                    [key: string]: (...args: any[]) => void;
                };
            };
            ajax?: {
                CRC?: {
                    view?: {
                        history?: {
                            doRefreshAll: () => void;
                        };
                    };
                };
            };
        };
        ACE_REST_URL?: string;
    }
}