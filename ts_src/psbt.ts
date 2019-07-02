import { Psbt as PsbtBase } from 'bip174';
import { PsbtInput } from 'bip174/src/lib/interfaces';
import { checkForInput } from 'bip174/src/lib/utils';
import { hash160 } from './crypto';
import { Signer } from './ecpair';
import { Network } from './networks';
import * as payments from './payments';
import * as bscript from './script';
import { Transaction } from './transaction';

export class Psbt extends PsbtBase {
  // protected __TX: Transaction;
  constructor(public network?: Network) {
    super();
    // // TODO: figure out a way to use a Transaction Object instead of a Buffer
    // // TODO: Caching, since .toBuffer() calls every time we get is lame.
    // this.__TX = Transaction.fromBuffer(this.globalMap.unsignedTx!);
    // delete this.globalMap.unsignedTx;
    // Object.defineProperty(this.globalMap, 'unsignedTx', {
    //   enumerable: true,
    //   writable: false,
    //   get(): Buffer {
    //     return this.__TX.toBuffer();
    //   }
    // });
  }

  canFinalize(inputIndex: number): boolean {
    const input = checkForInput(this.inputs, inputIndex);
    const script = getScriptFromInput(
      inputIndex,
      input,
      this.globalMap.unsignedTx!,
    );
    if (!script) return false;
    const scriptType = classifyScript(script);

    const hasSigs = (neededSigs: number, partialSig?: any[]): boolean => {
      if (!partialSig) return false;
      if (partialSig.length > neededSigs)
        throw new Error('Too many signatures');
      return partialSig.length === neededSigs;
    };

    switch (scriptType) {
      case 'pubkey':
        return hasSigs(1, input.partialSig);
      case 'pubkeyhash':
        return hasSigs(1, input.partialSig);
      case 'multisig':
        const p2ms = payments.p2ms({ output: script });
        return hasSigs(p2ms.m!, input.partialSig);
      case 'witnesspubkeyhash':
        return hasSigs(1, input.partialSig);
      default:
        return false;
    }
  }

  signInput(inputIndex: number, keyPair: Signer): Psbt {
    const input = this.inputs[inputIndex];
    if (input === undefined) throw new Error(`No input #${inputIndex}`);
    const { hash, sighashType, script } = getHashForSig(
      inputIndex,
      input,
      this.globalMap.unsignedTx!,
    );

    const pubkey = keyPair.publicKey;
    const pubkeyHash = hash160(keyPair.publicKey);

    const decompiled = bscript.decompile(script);
    if (decompiled === null) throw new Error('Unknown script error');

    const hasKey = decompiled.some(element => {
      if (typeof element === 'number') return false;
      return element.equals(pubkey) || element.equals(pubkeyHash);
    });

    if (!hasKey) {
      throw new Error(
        `Can not sign for this input with the key ${pubkey.toString('hex')}`,
      );
    }

    const partialSig = {
      pubkey,
      signature: bscript.signature.encode(keyPair.sign(hash), sighashType),
    };

    return this.addPartialSigToInput(inputIndex, partialSig);
  }
}

interface HashForSigData {
  script: Buffer;
  hash: Buffer;
  sighashType: number;
}

const getHashForSig = (
  inputIndex: number,
  input: PsbtInput,
  txBuf: Buffer,
): HashForSigData => {
  const unsignedTx = Transaction.fromBuffer(txBuf);
  const sighashType = input.sighashType || Transaction.SIGHASH_ALL;
  let hash: Buffer;
  let script: Buffer;

  if (input.nonWitnessUtxo) {
    const nonWitnessUtxoTx = Transaction.fromBuffer(input.nonWitnessUtxo);

    const prevoutHash = unsignedTx.ins[inputIndex].hash;
    const utxoHash = nonWitnessUtxoTx.getHash();

    // If a non-witness UTXO is provided, its hash must match the hash specified in the prevout
    if (!prevoutHash.equals(utxoHash)) {
      throw new Error(
        `Non-witness UTXO hash for input #${inputIndex} doesn't match the hash specified in the prevout`,
      );
    }

    const prevoutIndex = unsignedTx.ins[inputIndex].index;
    const prevout = nonWitnessUtxoTx.outs[prevoutIndex];

    if (input.redeemScript) {
      // If a redeemScript is provided, the scriptPubKey must be for that redeemScript
      checkRedeemScript(inputIndex, prevout.script, input.redeemScript);
      script = input.redeemScript;
      hash = unsignedTx.hashForSignature(
        inputIndex,
        input.redeemScript,
        sighashType,
      );
    } else {
      script = prevout.script;
      hash = unsignedTx.hashForSignature(
        inputIndex,
        prevout.script,
        sighashType,
      );
    }
  } else if (input.witnessUtxo) {
    let _script: Buffer; // so we don't shadow the `let script` above
    if (input.redeemScript) {
      // If a redeemScript is provided, the scriptPubKey must be for that redeemScript
      checkRedeemScript(
        inputIndex,
        input.witnessUtxo.script,
        input.redeemScript,
      );
      _script = input.redeemScript;
    } else {
      _script = input.witnessUtxo.script;
    }
    if (isP2WPKH(_script)) {
      // P2WPKH uses the P2PKH template for prevoutScript when signing
      const signingScript = payments.p2pkh({ hash: _script.slice(2) }).output!;
      hash = unsignedTx.hashForWitnessV0(
        inputIndex,
        signingScript,
        input.witnessUtxo.value,
        sighashType,
      );
      script = _script;
    } else {
      if (!input.witnessScript)
        throw new Error('Segwit input needs witnessScript if not P2WPKH');
      checkWitnessScript(inputIndex, _script, input.witnessScript);
      hash = unsignedTx.hashForWitnessV0(
        inputIndex,
        _script,
        input.witnessUtxo.value,
        sighashType,
      );
      // want to make sure the script we return is the actual meaningful script
      script = input.witnessScript;
    }
  } else {
    throw new Error('Need a Utxo input item for signing');
  }
  return {
    script,
    sighashType,
    hash,
  };
};

type ScriptCheckerFunction = (idx: number, spk: Buffer, rs: Buffer) => void;

const scriptCheckerFactory = (
  payment: any,
  paymentScriptName: string,
): ScriptCheckerFunction => (
  inputIndex: number,
  scriptPubKey: Buffer,
  redeemScript: Buffer,
): void => {
  const redeemScriptOutput = payment({
    redeem: { output: redeemScript },
  }).output as Buffer;

  if (!scriptPubKey.equals(redeemScriptOutput)) {
    throw new Error(
      `${paymentScriptName} for input #${inputIndex} doesn't match the scriptPubKey in the prevout`,
    );
  }
};

const checkRedeemScript = scriptCheckerFactory(payments.p2sh, 'Redeem script');
const checkWitnessScript = scriptCheckerFactory(
  payments.p2wsh,
  'Witness script',
);

type isPaymentFunction = (script: Buffer) => boolean;

const isPaymentFactory = (payment: any): isPaymentFunction => (
  script: Buffer,
): boolean => {
  try {
    payment({ output: script });
    return true;
  } catch (err) {
    return false;
  }
};
const isP2WPKH = isPaymentFactory(payments.p2wpkh);
const isP2PKH = isPaymentFactory(payments.p2pkh);
const isP2MS = isPaymentFactory(payments.p2ms);
const isP2PK = isPaymentFactory(payments.p2pk);

const classifyScript = (script: Buffer): string => {
  if (isP2WPKH(script)) return 'witnesspubkeyhash';
  if (isP2PKH(script)) return 'pubkeyhash';
  if (isP2MS(script)) return 'multisig';
  if (isP2PK(script)) return 'pubkey';
  return 'nonstandard';
};

function getScriptFromInput(
  inputIndex: number,
  input: PsbtInput,
  _unsignedTx: Buffer,
): Buffer | undefined {
  let script: Buffer;
  if (input.nonWitnessUtxo) {
    if (input.redeemScript) {
      script = input.redeemScript;
    } else {
      const unsignedTx = Transaction.fromBuffer(_unsignedTx);
      const nonWitnessUtxoTx = Transaction.fromBuffer(input.nonWitnessUtxo);
      const prevoutIndex = unsignedTx.ins[inputIndex].index;
      script = nonWitnessUtxoTx.outs[prevoutIndex].script;
    }
  } else if (input.witnessUtxo) {
    if (input.witnessScript) {
      script = input.witnessScript;
    } else if (input.redeemScript) {
      script = payments.p2pkh({ hash: input.redeemScript.slice(2) }).output!;
    } else {
      script = payments.p2pkh({ hash: input.witnessUtxo.script.slice(2) })
        .output!;
    }
  } else {
    return;
  }
  return script;
}
