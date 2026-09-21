import ExclamationTriangleIcon from '@patternfly/react-icons/dist/esm/icons/exclamation-triangle-icon';
import styles from './ErrorPanel.module.css';

export function friendlyErrorTitle(code: string | null): string {
  switch (code) {
    case 'AIC_TIMEOUT': return 'Request timed out';
    case 'AIC_NO_CONFIGURATION': return 'No valid configuration found';
    case 'AIC_UNAVAILABLE': return 'Sizing service unavailable';
    case 'AIC_NOT_CONFIGURED': return 'Service not configured';
    case 'AIC_UNSUPPORTED': return 'Configuration does not fit';
    case 'AIC_INVALID_RESPONSE': return 'Unexpected response';
    case 'INVALID_REQUEST': return 'Invalid input';
    case 'NETWORK_ERROR': return 'Connection error';
    default: return 'Something went wrong';
  }
}

export function friendlyErrorMessage(code: string | null, raw: string): string {
  switch (code) {
    case 'AIC_TIMEOUT':
      return 'The AIConfigurator service took too long to respond. This can happen with complex configurations.';
    case 'AIC_NO_CONFIGURATION':
      return 'No valid GPU configuration found for this model and hardware combination.';
    case 'AIC_UNAVAILABLE':
      return 'The AIConfigurator service is temporarily unreachable. This is usually a transient issue.';
    case 'AIC_NOT_CONFIGURED':
      return 'The AIConfigurator service URL is not configured.';
    case 'AIC_UNSUPPORTED':
      return 'This model and hardware combination is not supported, or the model is too large to fit on the selected GPU.';
    case 'AIC_INVALID_RESPONSE':
      return 'The sizing engine returned an unexpected response format.';
    case 'INVALID_REQUEST':
      return 'Some input values are missing or invalid. Please check your model name and parameters.';
    case 'NETWORK_ERROR':
      return 'Could not reach a REST API service or it took too long to respond.';
    default:
      return raw;
  }
}

export function friendlyErrorHint(code: string | null): string {
  switch (code) {
    case 'AIC_TIMEOUT':
      return 'Try again, or try a smaller model or simpler configuration.';
    case 'AIC_NO_CONFIGURATION':
      return 'Try a different GPU system, or reduce the input token length (ISL).';
    case 'AIC_UNAVAILABLE':
      return 'Wait a moment and try again.';
    case 'AIC_UNSUPPORTED':
      return 'Try a GPU with more memory, reduce parallelism, or use a smaller/quantized model.';
    case 'NETWORK_ERROR':
      return 'Check your connection and try again.';
    case 'INVALID_REQUEST':
      return 'Make sure the model name is a valid Hugging Face ID (e.g. meta-llama/Llama-3.1-70B-Instruct).';
    default:
      return 'If this persists, try a different model or GPU combination.';
  }
}

interface ErrorPanelProps {
  error: string;
  errorCode: string | null;
}

export function ErrorPanel({ error, errorCode }: ErrorPanelProps) {
  return (
    <div className={styles.errorWrap}>
      <div className={styles.errorTitle}>
        <ExclamationTriangleIcon /> {friendlyErrorTitle(errorCode)}
      </div>
      <div className={styles.errorMsg}>{friendlyErrorMessage(errorCode, error)}</div>
      <div className={styles.errorHint}>{friendlyErrorHint(errorCode)}</div>
    </div>
  );
}
