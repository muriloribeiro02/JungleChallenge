import {
  optionalIntInRange,
  optionalNonNegativeInt,
  optionalPositiveInt,
} from '../../src/shared/parse-env-int';

describe('parse-env-int', () => {
  describe('optionalPositiveInt', () => {
    it('usa default quando ausente ou em branco', () => {
      expect(optionalPositiveInt('X', undefined, 10)).toBe(10);
      expect(optionalPositiveInt('X', '', 10)).toBe(10);
      expect(optionalPositiveInt('X', '  ', 10)).toBe(10);
    });

    it('aceita inteiro >= 1', () => {
      expect(optionalPositiveInt('X', '1', 10)).toBe(1);
      expect(optionalPositiveInt('X', '42', 10)).toBe(42);
    });

    it('rejeita NaN, zero, negativo, não inteiro e identifica a variável', () => {
      expect(() => optionalPositiveInt('FOO', 'abc', 10)).toThrow(/FOO/);
      expect(() => optionalPositiveInt('FOO', '0', 10)).toThrow(/FOO/);
      expect(() => optionalPositiveInt('FOO', '-1', 10)).toThrow(/FOO/);
      expect(() => optionalPositiveInt('FOO', '1.5', 10)).toThrow(/FOO/);
      expect(() => optionalPositiveInt('FOO', 'NaN', 10)).toThrow(/FOO/);
    });
  });

  describe('optionalNonNegativeInt', () => {
    it('aceita 0 e positivos; rejeita inválidos', () => {
      expect(optionalNonNegativeInt('H', undefined, 0)).toBe(0);
      expect(optionalNonNegativeInt('H', '0', 7)).toBe(0);
      expect(optionalNonNegativeInt('H', '3', 7)).toBe(3);
      expect(() => optionalNonNegativeInt('H', '-1', 0)).toThrow(/H/);
      expect(() => optionalNonNegativeInt('H', '1.1', 0)).toThrow(/H/);
    });
  });

  describe('optionalIntInRange', () => {
    it('aplica default e limites inclusivos (ex.: SQS WaitTimeSeconds 0–20)', () => {
      expect(optionalIntInRange('W', undefined, 1, 0, 20)).toBe(1);
      expect(optionalIntInRange('W', '0', 1, 0, 20)).toBe(0);
      expect(optionalIntInRange('W', '20', 1, 0, 20)).toBe(20);
      expect(() => optionalIntInRange('SQS_RECEIVE_WAIT_SECONDS', '21', 1, 0, 20)).toThrow(
        /SQS_RECEIVE_WAIT_SECONDS/,
      );
      expect(() => optionalIntInRange('M', '0', 10, 1, 10)).toThrow(/M/);
      expect(() => optionalIntInRange('M', '11', 10, 1, 10)).toThrow(/M/);
    });
  });
});
