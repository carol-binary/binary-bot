import clone from 'clone';
import JSInterpreter from 'js-interpreter';
import { observer as globalObserver } from '../../common/utils/observer';
import { createScope } from './CliTools';
import Interface from './Interface';

/* eslint-disable func-names, no-underscore-dangle */
JSInterpreter.prototype.takeStateSnapshot = function() {
    const newStateStack = clone(this.stateStack, undefined, undefined, undefined, true);
    return newStateStack;
};

JSInterpreter.prototype.restoreStateSnapshot = function(snapshot) {
    this.stateStack = clone(snapshot, undefined, undefined, undefined, true);
    this.globalObject = this.stateStack[0].scope.object;
    this.initFunc_(this, this.globalObject);
};
/* eslint-enable */

const unrecoverableErrors = [
    'InsufficientBalance',
    'CustomLimitsReached',
    'OfferingsValidationError',
    'InvalidCurrency',
    'NotDefaultCurrency',
    'PleaseAuthenticate',
    'FinancialAssessmentRequired',
    'AuthorizationRequired',
    'InvalidToken',
];
const botInitialized = bot => bot && bot.tradeEngine.options;
const botStarted = bot => botInitialized(bot) && bot.tradeEngine.tradeOptions;
const shouldRestartOnError = (bot, errorName = '') =>
    !unrecoverableErrors.includes(errorName) && botInitialized(bot) && bot.tradeEngine.options.shouldRestartOnError;

const shouldStopOnError = (bot, errorName = '') => {
    const stopErrors = ['SellNotAvailableCustom'];
    if (stopErrors.includes(errorName) && botInitialized(bot)) {
        return true;
    }
    return false;
};

const timeMachineEnabled = bot => botInitialized(bot) && bot.tradeEngine.options.timeMachineEnabled;

export default class Interpreter {
    constructor() {
        this.init();
    }
    init() {
        this.$scope = createScope();
        this.bot = new Interface(this.$scope);
        this.stopped = false;
        this.$scope.observer.register('REVERT', watchName =>
            this.revert(watchName === 'before' ? this.beforeState : this.duringState)
        );
    }
    run(code) {
        const initFunc = (interpreter, scope) => {
            const BotIf = this.bot.getInterface('Bot');
            const ticksIf = this.bot.getTicksInterface();
            const { alert, prompt, sleep, console: customConsole } = this.bot.getInterface();

            interpreter.setProperty(scope, 'console', interpreter.nativeToPseudo(customConsole));

            interpreter.setProperty(scope, 'alert', interpreter.nativeToPseudo(alert));

            interpreter.setProperty(scope, 'prompt', interpreter.nativeToPseudo(prompt));

            const pseudoBotIf = interpreter.nativeToPseudo(BotIf);

            Object.entries(ticksIf).forEach(([name, f]) => {
                interpreter.setProperty(pseudoBotIf, name, this.createAsync(interpreter, f));
            });

            interpreter.setProperty(
                pseudoBotIf,
                'start',
                interpreter.nativeToPseudo((...args) => {
                    const { start } = BotIf;
                    if (shouldRestartOnError(this.bot)) {
                        this.startState = interpreter.takeStateSnapshot();
                    }
                    start(...args);
                })
            );

            interpreter.setProperty(pseudoBotIf, 'purchase', this.createAsync(interpreter, BotIf.purchase));

            interpreter.setProperty(pseudoBotIf, 'sellAtMarket', this.createAsync(interpreter, BotIf.sellAtMarket));

            interpreter.setProperty(scope, 'Bot', pseudoBotIf);

            interpreter.setProperty(
                scope,
                'watch',
                this.createAsync(interpreter, watchName => {
                    const { watch } = this.bot.getInterface();

                    if (timeMachineEnabled(this.bot)) {
                        const snapshot = this.interpreter.takeStateSnapshot();
                        if (watchName === 'before') {
                            this.beforeState = snapshot;
                        } else {
                            this.duringState = snapshot;
                        }
                    }

                    return watch(watchName);
                })
            );

            interpreter.setProperty(scope, 'sleep', this.createAsync(interpreter, sleep));
        };

        return new Promise((resolve, reject) => {
            const onError = e => {
                if (this.stopped) {
                    return;
                }

                if (shouldStopOnError(this.bot, e.name)) {
                    globalObserver.emit('ui.log.error', e.message);
                    $('#stopButton').trigger('click');
                    this.stop();
                    return;
                }

                this.isErrorTriggered = true;
                if (!shouldRestartOnError(this.bot, e.name) || !botStarted(this.bot)) {
                    reject(e);
                    return;
                }

                globalObserver.emit('Error', e);
                const { initArgs, tradeOptions } = this.bot.tradeEngine;
                this.terminateSession();
                this.init();
                this.$scope.observer.register('Error', onError);
                this.bot.tradeEngine.init(...initArgs);
                this.bot.tradeEngine.start(tradeOptions);
                this.revert(this.startState);
            };

            this.$scope.observer.register('Error', onError);

            this.interpreter = new JSInterpreter(code, initFunc);

            this.onFinish = resolve;
            this.loop();
        });
    }
    loop() {
        if (this.stopped || !this.interpreter.run()) {
            this.isErrorTriggered = false;
            this.onFinish(this.interpreter.pseudoToNative(this.interpreter.value));
        }
    }
    revert(state) {
        this.interpreter.restoreStateSnapshot(state);
        // eslint-disable-next-line no-underscore-dangle
        this.interpreter.paused_ = false;
        this.loop();
    }
    terminateSession() {
        this.$scope.api.disconnect();
        this.stopped = true;

        globalObserver.emit('bot.stop');
        globalObserver.setState({ isRunning: false });
    }
    stop() {
        if (this.bot.tradeEngine.isSold === false && !this.isErrorTriggered) {
            globalObserver.register('contract.status', contractStatus => {
                if (contractStatus.id === 'contract.sold') {
                    this.terminateSession();
                    globalObserver.unregisterAll('contract.status');
                }
            });
        } else {
            this.terminateSession();
        }
    }
    createAsync(interpreter, func) {
        const asyncFunc = (...args) => {
            const callback = args.pop();

            // Workaround for unknown number of args
            const reversedArgs = args.slice().reverse();
            const firsDefinedArgIdx = reversedArgs.findIndex(arg => arg !== undefined);

            // Remove extra undefined args from end of the args
            const functionArgs = firsDefinedArgIdx < 0 ? [] : reversedArgs.slice(firsDefinedArgIdx).reverse();
            // End of workaround

            func(...functionArgs.map(arg => interpreter.pseudoToNative(arg)))
                .then(rv => {
                    callback(interpreter.nativeToPseudo(rv));
                    this.loop();
                })
                .catch(e => this.$scope.observer.emit('Error', e));
        };

        // TODO: This is a workaround, create issue on original repo, once fixed
        // remove this. We don't know how many args are going to be passed, so we
        // assume a max of 100.
        const MAX_ACCEPTABLE_FUNC_ARGS = 100;
        Object.defineProperty(asyncFunc, 'length', { value: MAX_ACCEPTABLE_FUNC_ARGS + 1 });
        return interpreter.createAsyncFunction(asyncFunc);
    }
    hasStarted() {
        return !this.stopped;
    }
}
