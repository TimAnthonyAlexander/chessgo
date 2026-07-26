import Foundation

/// Decoding helpers that survive server schema drift: a field the backend adds
/// or renames in a deploy shouldn't sink the whole response. Identity fields
/// (`id`, `name`) stay non-optional and crash loud on a genuinely broken body;
/// anything that can drift gets a `@Default*` wrapper.
///
/// Ported from the lycea iOS app's `Resilient.swift`.

protocol DecodableDefaultSource {
    associatedtype Value: Decodable
    static var defaultValue: Value { get }
}

@propertyWrapper
struct Default<Source: DecodableDefaultSource>: Decodable {
    var wrappedValue: Source.Value

    init() { wrappedValue = Source.defaultValue }
    init(wrappedValue: Source.Value) { self.wrappedValue = wrappedValue }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        wrappedValue = (try? container.decode(Source.Value.self)) ?? Source.defaultValue
    }
}

extension Default: Equatable where Source.Value: Equatable {}
extension Default: Hashable where Source.Value: Hashable {}

/// Encode transparently when the value is Encodable, so a model can be
/// `Codable` even though the wrapper's decode side supplies defaults.
extension Default: Encodable where Source.Value: Encodable {
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(wrappedValue)
    }
}

/// Missing/null key → default, instead of throwing.
extension KeyedDecodingContainer {
    func decode<Source>(_ type: Default<Source>.Type, forKey key: Key) throws -> Default<Source> {
        ((try? decodeIfPresent(type, forKey: key)) ?? nil) ?? Default<Source>()
    }
}

// MARK: - Common sources

enum DefaultSources {
    enum False: DecodableDefaultSource { static let defaultValue = false }
    enum True: DecodableDefaultSource { static let defaultValue = true }
    enum Zero: DecodableDefaultSource { static let defaultValue = 0 }
    enum ZeroDouble: DecodableDefaultSource { static let defaultValue = 0.0 }
    enum EmptyString: DecodableDefaultSource { static let defaultValue = "" }
}

typealias DefaultFalse = Default<DefaultSources.False>
typealias DefaultTrue = Default<DefaultSources.True>
typealias DefaultZero = Default<DefaultSources.Zero>
typealias DefaultZeroDouble = Default<DefaultSources.ZeroDouble>
typealias DefaultEmptyString = Default<DefaultSources.EmptyString>

/// An array that defaults to `[]` when missing/null AND drops individually
/// malformed elements rather than failing the whole decode.
@propertyWrapper
struct DefaultEmptyArray<Element: Decodable>: Decodable {
    var wrappedValue: [Element]

    init() { wrappedValue = [] }
    init(wrappedValue: [Element]) { self.wrappedValue = wrappedValue }

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var result: [Element] = []
        while !container.isAtEnd {
            if let value = try? container.decode(Lossy<Element>.self), let element = value.value {
                result.append(element)
            } else {
                _ = try? container.decode(AnyDecodable.self)
            }
        }
        wrappedValue = result
    }
}

extension KeyedDecodingContainer {
    func decode<Element>(_ type: DefaultEmptyArray<Element>.Type, forKey key: Key) throws -> DefaultEmptyArray<Element> {
        ((try? decodeIfPresent(type, forKey: key)) ?? nil) ?? DefaultEmptyArray<Element>()
    }
}

/// Decodes to `nil` instead of throwing when an element is malformed.
private struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        value = try? container.decode(T.self)
    }
}

/// Consumes an arbitrary JSON value so a bad array element can be skipped.
private struct AnyDecodable: Decodable {
    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { return }
        if (try? container.decode(Bool.self)) != nil { return }
        if (try? container.decode(Double.self)) != nil { return }
        if (try? container.decode(String.self)) != nil { return }
        if (try? container.decode([AnyDecodable].self)) != nil { return }
        _ = try? container.decode([String: AnyDecodable].self)
    }
}
