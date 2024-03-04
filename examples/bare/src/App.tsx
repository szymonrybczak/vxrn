import { View, Text, StyleSheet, Image } from 'react-native'
import vxrn from './vxrn.png'
import chevron from 'react-native/Libraries/LogBox/UI/LogBoxImages/alert-triangle.png'
// to tak trzeba zrobic ze przy budowaniu tej depki te pliki beda wchodzic, tylko pozniej trzeba jakos sprytnie path obczaic

const App = () => {
  return (
    <View style={styles.container}>
      <Text>Hello, world!</Text>
      <Image source={chevron} />
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
})

export default App
